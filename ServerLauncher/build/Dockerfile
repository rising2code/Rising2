# Toolchain only: cross-compiles r2launch.exe (32-bit, like the server)
FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/rising2code/Rising2" \
      rising2.dockerfile="ServerLauncher/build/Dockerfile"
RUN apt-get update && apt-get install -y --no-install-recommends gcc-mingw-w64-i686 make && rm -rf /var/lib/apt/lists/*
WORKDIR /src
CMD ["sh", "-c", "i686-w64-mingw32-gcc -O2 -s -Wall -o /out/r2launch.exe r2launch.c -luser32 -static-libgcc"]
