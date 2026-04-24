import * as os from "os";
import * as path from "path";

/** Ensures ~/.local/bin is on PATH for Cursor CLI subprocesses. */
export function augmentPathEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const localBin = path.join(os.homedir(), ".local", "bin");
	const pathEnv = base.PATH ?? "";
	const mergedPath = pathEnv.includes(localBin)
		? pathEnv
		: `${localBin}${path.delimiter}${pathEnv}`;
	return { ...base, PATH: mergedPath };
}
