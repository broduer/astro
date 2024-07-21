import fsMod from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dim } from 'kleur/colors';
import { type HMRPayload, createServer } from 'vite';
import type { AstroConfig, AstroInlineConfig, AstroSettings } from '../../@types/astro.js';
import { getPackage } from '../../cli/install-package.js';
import { createContentTypesGenerator } from '../../content/index.js';
import { globalContentConfigObserver } from '../../content/utils.js';
import { syncAstroEnv } from '../../env/sync.js';
import { telemetry } from '../../events/index.js';
import { eventCliSession } from '../../events/session.js';
import { runHookConfigSetup } from '../../integrations/hooks.js';
import { getTimeStat } from '../build/util.js';
import { resolveConfig } from '../config/config.js';
import { createNodeLogger } from '../config/logging.js';
import { createSettings } from '../config/settings.js';
import { createVite } from '../create-vite.js';
import { collectErrorMetadata } from '../errors/dev/utils.js';
import {
	AstroError,
	AstroErrorData,
	AstroUserError,
	createSafeError,
	isAstroError,
} from '../errors/index.js';
import type { Logger } from '../logger/core.js';
import { formatErrorMessage } from '../messages.js';
import { ensureProcessNodeEnv } from '../util.js';
import { setUpEnvTs } from './setup-env-ts.js';

export type SyncOptions = {
	/**
	 * @internal only used for testing
	 */
	fs?: typeof fsMod;
	logger: Logger;
	settings: AstroSettings;
	skip?: {
		// Must be skipped in dev
		content?: boolean;
	};
};

type DBPackage = {
	typegen?: (args: Pick<AstroConfig, 'root' | 'integrations'>) => Promise<void>;
};

export default async function sync({
	inlineConfig,
	fs,
	telemetry: _telemetry = false,
}: { inlineConfig: AstroInlineConfig; fs?: typeof fsMod; telemetry?: boolean }) {
	ensureProcessNodeEnv('production');
	const logger = createNodeLogger(inlineConfig);
	const { astroConfig, userConfig } = await resolveConfig(inlineConfig ?? {}, 'sync');
	if (_telemetry) {
		telemetry.record(eventCliSession('sync', userConfig));
	}
	let settings = await createSettings(astroConfig, inlineConfig.root);
	settings = await runHookConfigSetup({
		command: 'build',
		settings,
		logger,
	});
	return await syncInternal({ settings, logger, fs });
}

/**
 * Generates TypeScript types for all Astro modules. This sets up a `src/env.d.ts` file for type inferencing,
 * and defines the `astro:content` module for the Content Collections API.
 *
 * @experimental The JavaScript API is experimental
 */
export async function syncInternal({
	logger,
	fs = fsMod,
	settings,
	skip,
}: SyncOptions): Promise<void> {
	const cwd = fileURLToPath(settings.config.root);

	const timerStart = performance.now();
	const dbPackage = await getPackage<DBPackage>(
		'@astrojs/db',
		logger,
		{
			optional: true,
			cwd,
		},
		[]
	);

	try {
		await dbPackage?.typegen?.(settings.config);
		if (!skip?.content) {
			await syncContentCollections(settings, { fs, logger });
		}
		syncAstroEnv(settings, fs);

		await setUpEnvTs({ settings, logger, fs });
		logger.info('types', `Generated ${dim(getTimeStat(timerStart, performance.now()))}`);
	} catch (err) {
		const error = createSafeError(err);
		logger.error(
			'types',
			formatErrorMessage(collectErrorMetadata(error), logger.level() === 'debug') + '\n'
		);
		// Will return exit code 1 in CLI
		throw error;
	}
}

/**
 * Generate content collection types, and then returns the process exit signal.
 *
 * A non-zero process signal is emitted in case there's an error while generating content collection types.
 *
 * This should only be used when the callee already has an `AstroSetting`, otherwise use `sync()` instead.
 * @internal
 *
 * @param {SyncOptions} options
 * @param {AstroSettings} settings Astro settings
 * @param {typeof fsMod} options.fs The file system
 * @param {LogOptions} options.logging Logging options
 * @return {Promise<ProcessExit>}
 */
async function syncContentCollections(
	settings: AstroSettings,
	{ logger, fs }: Required<Pick<SyncOptions, 'logger' | 'fs'>>
): Promise<void> {
	// Needed to load content config
	const tempViteServer = await createServer(
		await createVite(
			{
				server: { middlewareMode: true, hmr: false, watch: null },
				optimizeDeps: { noDiscovery: true },
				ssr: { external: [] },
				logLevel: 'silent',
			},
			{ settings, logger, mode: 'build', command: 'build', fs, sync: true }
		)
	);

	// Patch `hot.send` to bubble up error events
	// `hot.on('error')` does not fire for some reason
	const hotSend = tempViteServer.hot.send;
	tempViteServer.hot.send = (payload: HMRPayload) => {
		if (payload.type === 'error') {
			throw payload.err;
		}
		return hotSend(payload);
	};

	try {
		const contentTypesGenerator = await createContentTypesGenerator({
			contentConfigObserver: globalContentConfigObserver,
			logger: logger,
			fs,
			settings,
			viteServer: tempViteServer,
		});
		const typesResult = await contentTypesGenerator.init();

		const contentConfig = globalContentConfigObserver.get();
		if (contentConfig.status === 'error') {
			throw contentConfig.error;
		}

		if (typesResult.typesGenerated === false) {
			switch (typesResult.reason) {
				case 'no-content-dir':
				default:
					logger.debug('types', 'No content directory found. Skipping type generation.');
			}
		}
	} catch (e) {
		const safeError = createSafeError(e);
		if (isAstroError(e)) {
			throw e;
		}
		const hint = AstroUserError.is(e) ? e.hint : AstroErrorData.GenerateContentTypesError.hint;
		throw new AstroError(
			{
				...AstroErrorData.GenerateContentTypesError,
				hint,
				message: AstroErrorData.GenerateContentTypesError.message(safeError.message),
			},
			{ cause: e }
		);
	} finally {
		await tempViteServer.close();
	}
}
