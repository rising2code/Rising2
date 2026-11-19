# Rising2 dedicated server: the 2008 Windows server under Wine, started by r2launch.exe.
# The game files are NOT in the image: mount the install folder at /game (see README).
FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/yonixw/Rising2" \
      rising2.dockerfile="ServerLauncher/docker/Dockerfile"

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine32 xvfb xauth ca-certificates procps \
      libgl1:i386 libglx-mesa0:i386 libgl1-mesa-dri:i386 mesa-utils \
 && rm -rf /var/lib/apt/lists/*

ENV WINEPREFIX=/wine \
    WINEARCH=win32 \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES="mscoree,mshtml=" \
    DISPLAY=:99

# Create the Wine prefix at build time so a container start doesn't spend ~30 s on it.
RUN xvfb-run -a wineboot -i && wineserver -w

COPY bin/r2launch.exe /opt/r2launch/r2launch.exe
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
