import { setVfileFrontmatter } from '@astrojs/markdown-remark';
import type { SSRError } from 'astro';
import { getAstroMetadata } from 'astro/jsx/rehype.js';
import { VFile } from 'vfile';
import type { Plugin } from 'vite';
import type { MdxOptions } from './index.js';
import { createMdxProcessor } from './plugins.js';
import { parseFrontmatter } from './utils.js';

export function vitePluginMdx(mdxOptions: MdxOptions): Plugin {
	let processor: ReturnType<typeof createMdxProcessor> | undefined;

	return {
		name: '@mdx-js/rollup',
		enforce: 'pre',
		buildEnd() {
			processor = undefined;
		},
		configResolved(resolved) {
			// `mdxOptions` should be populated at this point, but `astro sync` doesn't call `astro:config:done` :(
			// Workaround this for now by skipping here. `astro sync` shouldn't call the `transform()` hook here anyways.
			if (Object.keys(mdxOptions).length === 0) return;

			processor = createMdxProcessor(mdxOptions, {
				sourcemap: !!resolved.build.sourcemap,
			});

			// HACK: Remove the `astro:jsx` plugin if defined as we handle the JSX transformation ourselves
			const jsxPluginIndex = resolved.plugins.findIndex((p) => p.name === 'astro:jsx');
			if (jsxPluginIndex !== -1) {
				// @ts-ignore-error ignore readonly annotation
				resolved.plugins.splice(jsxPluginIndex, 1);
			}
		},
		async resolveId(source, importer, options) {
			if (importer?.endsWith('.mdx') && source[0] !== '/') {
				let resolved = await this.resolve(source, importer, options);
				if (!resolved) resolved = await this.resolve('./' + source, importer, options);
				return resolved;
			}
		},
		// Override transform to alter code before MDX compilation
		// ex. inject layouts
		async transform(code, id) {
			if (!id.endsWith('.mdx')) return;

			const { data: frontmatter, content: pageContent } = parseFrontmatter(code, id);

			const vfile = new VFile({ value: pageContent, path: id });
			// Ensure `data.astro` is available to all remark plugins
			setVfileFrontmatter(vfile, frontmatter);

			// `processor` is initialized in `configResolved`, and removed in `buildEnd`. `transform`
			// should be called in between those two lifecycle, so this error should never happen
			if (!processor) {
				return this.error(
					'MDX processor is not initialized. This is an internal error. Please file an issue.'
				);
			}

			try {
				const compiled = await processor.process(vfile);

				return {
					code: String(compiled.value),
					map: compiled.map,
					meta: getMdxMeta(vfile),
				};
			} catch (e: any) {
				const err: SSRError = e;

				// For some reason MDX puts the error location in the error's name, not very useful for us.
				err.name = 'MDXError';
				err.loc = { file: id, line: e.line, column: e.column };

				// For another some reason, MDX doesn't include a stack trace. Weird
				Error.captureStackTrace(err);

				throw err;
			}
		},
	};
}

function getMdxMeta(vfile: VFile): Record<string, any> {
	const astroMetadata = getAstroMetadata(vfile);
	if (!astroMetadata) {
		throw new Error(
			'Internal MDX error: Astro metadata is not set by rehype-analyze-astro-metadata'
		);
	}
	return {
		astro: astroMetadata,
		vite: {
			// Setting this vite metadata to `ts` causes Vite to resolve .js
			// extensions to .ts files.
			lang: 'ts',
		},
	};
}
