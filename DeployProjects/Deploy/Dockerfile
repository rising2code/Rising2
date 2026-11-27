# Rising2 deploy tools: node + wrangler, nothing installed on your machine.
# The code is not baked in: DeployProjects is mounted read-only at /app when you run it (README.md).
FROM node:20-bookworm-slim

RUN npm install -g wrangler@3.114.17 && npm cache clean --force

# The docker CLI + buildx, for the Docker Hub steps (04a, 04b): they build and push through your
# Docker Desktop (its socket is mounted only for those steps); no Docker engine runs in here.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp
ENV WRANGLER_SEND_METRICS=false
ENTRYPOINT ["node", "/app/Deploy/run.mjs"]

LABEL org.opencontainers.image.source="https://github.com/rising2code/Rising2" \
      rising2.dockerfile="DeployProjects/Deploy/Dockerfile"
