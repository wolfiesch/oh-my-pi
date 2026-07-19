export interface SccacheFallbackProbe {
	exitCode: number;
	rustcWrapper: string | undefined;
	stdout: string;
	stderr: string;
}

export function shouldRetryNapiBuildWithoutSccache(probe: SccacheFallbackProbe): boolean {
	if (probe.exitCode === 0 || probe.rustcWrapper !== "sccache") return false;
	return probe.stdout.includes("sccache: error") || probe.stderr.includes("sccache: error");
}
