import { readFileSync, writeFileSync } from 'node:fs'

// bridge-dds ships ESM in dist/ but omits "type": "module", so Node loads it as
// CommonJS and its named exports disappear. Bundlers cope; plain `node` does not.
const manifestPath = new URL('../node_modules/bridge-dds/package.json', import.meta.url)

try {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	if (manifest.type !== 'module') {
		manifest.type = 'module'
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
	}
} catch {
	// bridge-dds is optional until dependencies have been installed.
}

// Its relative imports are extensionless, which is illegal in ESM at runtime and
// under TypeScript's NodeNext resolution. Both the implementation and the types
// need the explicit extension.
const sourcePaths = ['dist/api.js', 'dist/api.d.ts']

for (const relative of sourcePaths) {
	const path = new URL(`../node_modules/bridge-dds/${relative}`, import.meta.url)
	try {
		const source = readFileSync(path, 'utf8')
		const patched = source.replaceAll('"./lib/dds"', '"./lib/dds.js"')
		if (patched !== source) writeFileSync(path, patched, 'utf8')
	} catch {
		// bridge-dds is optional until dependencies have been installed.
	}
}
