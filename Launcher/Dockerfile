# Builds Rising2_Launcher.exe on Linux. No Windows SDK, no CGO.
#   docker build --output dist .
# The version shown in the app comes from git, stamped by Go itself: the short commit
# (abc1234, +dirty if uncommitted), or "v0.2.0 (abc1234)" after `git tag v0.2.0`.
FROM golang:1.24.4-bookworm AS build
WORKDIR /src
ENV CGO_ENABLED=0
RUN go install github.com/tc-hib/go-winres@v0.3.3
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./... && GOOS=windows go vet ./...
# Icon + manifest (DPI aware, common controls) -> rsrc_windows_amd64.syso, linked automatically.
RUN go-winres make --in winres/winres.json --arch amd64 \
 && GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=true \
      -ldflags "-s -w -H windowsgui" \
      -o /out/Rising2_Launcher.exe .

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/yonixw/Rising2" \
      rising2.dockerfile="Launcher/Dockerfile"
COPY --from=build /out/ /
