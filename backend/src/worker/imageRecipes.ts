/**
 * Bakeable sandbox images — named-snapshot equivalents of the Dockerfiles in
 * backend/e2b-template/. A bake boots a stock VM, runs `commands`, verifies
 * with `verify`, then `createSnapshot({name})` so `Sandbox.create` can boot
 * straight from the snapshot (same template mechanism E2B builds produce).
 * Keep recipes in sync with their Dockerfile counterparts.
 */
export interface ImageRecipe {
	/** Stable image name — used as the snapshot name and in the Composer
	 *  template field / pickTemplate catalog. */
	imageName: string;
	/** Shell script run inside a stock E2B VM. */
	commands: string;
	/** Non-zero exit fails the bake. */
	verify?: string;
	timeoutMs?: number;
}

export const IMAGE_RECIPES: Record<string, ImageRecipe> = {
	// Mirrors backend/e2b-template/Dockerfile (kronyx-browser):
	// Qt/GUI libs + xvfb + browser-use + Playwright + Chromium.
	browser: {
		imageName: "kronyx-browser",
		commands: [
			"sudo apt-get update -qq",
			"sudo apt-get install -y --no-install-recommends libgl1 libegl1 libxkbcommon0 libxkbcommon-x11-0 libdbus-1-3 libfontconfig1 libglib2.0-0 libx11-6 libxext6 libxrender1 libsm6 xvfb python3-pip >/dev/null",
			"sudo pip3 install --no-cache-dir --break-system-packages browser-use playwright >/dev/null",
			// --with-deps needs root for the apt step; browsers themselves must
			// land in the runtime user's ~/.cache, not /root/.cache.
			"sudo python3 -m playwright install-deps chromium >/dev/null",
			"python3 -m playwright install chromium >/dev/null",
		].join(" && "),
		verify: `python3 -c "import browser_use, playwright; print('ok')"`,
		timeoutMs: 25 * 60_000,
	},
};
