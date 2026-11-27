# A placeholder: step 04a pushes it as <user>/<image>:placeholder so each Docker Hub repo exists
# before its real image is built (04b pushes :latest). It holds one text file and runs nothing.
FROM scratch
COPY README.txt /README.txt
LABEL org.opencontainers.image.source="https://github.com/rising2code/Rising2" \
      org.opencontainers.image.description="Rising2 placeholder: the real image is pushed as :latest" \
      rising2.dockerfile="DeployProjects/Deploy/placeholder/Dockerfile"
