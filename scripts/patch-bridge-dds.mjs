import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../node_modules/bridge-dds/dist/api.js', import.meta.url)

try {
	const source = readFileSync(path, 'utf8')
	const patched = source.replace('import DdsLoader from "./lib/dds";', 'import DdsLoader from "./lib/dds.js";')
	if (patched !== source) writeFileSync(path, patched, 'utf8')
} catch {
	// bridge-dds is optional until dependencies have been installed.
}
