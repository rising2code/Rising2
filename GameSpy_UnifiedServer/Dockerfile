FROM python:3.12-slim

LABEL org.opencontainers.image.title="Rising2 GameSpy Unified Server" \
      org.opencontainers.image.description="GameSpy mock for Rising Eagle: GP, QR2, server browser, CD key, Auth, Sake, Competition" \
      org.opencontainers.image.source="https://github.com/rising2code/Rising2" \
      rising2.dockerfile="GameSpy_UnifiedServer/Dockerfile"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    R2_DATA_DIR=/data

WORKDIR /app
COPY rising2 ./rising2
COPY db ./db
COPY config ./config
# pristine copy: used to recreate config/rules.py if a mounted config folder lacks it
COPY config/rules.py ./defaults/rules.py
COPY tools ./tools

RUN mkdir -p /data && python -m compileall -q rising2

VOLUME ["/data"]

# TCP: 29900 GPCM, 29901 GPSP, 28910 server browser, 80 HTTP (motd/auth/sake/competition)
# UDP: 27900 QR2, 29910 CD key, 27901 NatNeg (log only)
EXPOSE 80/tcp 28910/tcp 29900/tcp 29901/tcp 27900/udp 27901/udp 29910/udp

CMD ["python", "-m", "rising2"]
