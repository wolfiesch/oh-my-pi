const INLINE_EXTENSION_PATH = /^<inline(?:-loader)?-\d+>$/;

/** Whether an extension path names a session-local inline factory or loader. */
export function isInlineExtensionPath(path: string): boolean {
	return INLINE_EXTENSION_PATH.test(path);
}
