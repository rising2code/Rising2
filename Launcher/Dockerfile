# Builds Rising2_Launcher.exe on Linux. No Windows SDK, no CGO.
#   docker build --output dist .
FROM golang:1.24.4-bookworm AS build
WORKDIR /src
ENV CGO_ENABLED=0
RUN go install github.com/tc-hib/go-winres@v0.3.3
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./... && GOOS=windows go vet ./...
ARG VERSION=dev
# Icon + manifest (DPI aware, common controls) -> rsrc_windows_amd64.syso, linked automatically.
RUN go-winres make --in winres/winres.json --arch amd64 \
 && GOOS=windows GOARCH=amd64 go build -trimpath \
      -ldflags "-s -w -H windowsgui -X main.Version=${VERSION}" \
      -o /out/Rising2_Launcher.exe .

FROM scratch
COPY --from=build /out/ /
