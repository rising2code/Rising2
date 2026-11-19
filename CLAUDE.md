# Rising2 repo notes

## Dockerfiles

Every Dockerfile must label the image with where it was built from, so a pushed image
(Docker Hub, GHCR, ...) tells you which repo and which file produced it. Put the labels in
the **final stage** (labels in earlier build stages don't reach the image):

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/rising2code/Rising2" \
      rising2.dockerfile="<path/to/Dockerfile, relative to the repo root>"
```

Keep `rising2.dockerfile` correct when a Dockerfile is moved or renamed. Check an image with:
`docker inspect -f '{{json .Config.Labels}}' <image>`
