# Kronyx agent sandbox: stock E2B image + browser automation + Qt/GUI libs.
# Build once:  e2b template build --name kronyx-browser
# Then set "kronyx-browser" in the Composer's template field (or session.template).
FROM e2bdev/base

USER root

# Qt/GUI runtime deps (PyQt5/PySide import libGL) + Xvfb for headed runs.
# For tests prefer QT_QPA_PLATFORM=offscreen — no X server needed at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
		libgl1 libegl1 libxkbcommon0 libxkbcommon-x11-0 libdbus-1-3 \
		libfontconfig1 libglib2.0-0 libx11-6 libxext6 libxrender1 libsm6 \
		xvfb python3-pip \
	&& rm -rf /var/lib/apt/lists/*

# Browser automation: browser-use drives the agent loop, playwright provides
# the Chromium it controls. --with-deps pulls the browser's own system libs.
RUN pip3 install --no-cache-dir --break-system-packages browser-use playwright \
	&& playwright install --with-deps chromium

USER user
