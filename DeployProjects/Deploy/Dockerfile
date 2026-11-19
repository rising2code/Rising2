# Rising2 deploy tools: node + wrangler, nothing installed on your machine.
# The code is not baked in: DeployProjects is mounted read-only at /app when you run it (README.md).
FROM node:20-bookworm-slim

RUN npm install -g wrangler@3.114.17 && npm cache clean --force

WORKDIR /tmp
ENV WRANGLER_SEND_METRICS=false
ENTRYPOINT ["node", "/app/Deploy/run.mjs"]

LABEL org.opencontainers.image.source="https://github.com/rising2code/Rising2" \
      rising2.dockerfile="DeployProjects/Deploy/Dockerfile"
