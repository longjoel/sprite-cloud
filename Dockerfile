FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY games-vault.csproj ./
RUN dotnet restore games-vault.csproj

COPY . .
RUN dotnet publish games-vault.csproj -c Release -r linux-x64 -o /out --self-contained true

FROM ubuntu:24.04 AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gstreamer1.0-tools \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-libav \
        libgstreamer1.0-0 \
        libgstreamer-plugins-base1.0-0 \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -f gv \
    && groupmod -o -g 1000 gv \
    && useradd --create-home --uid 1000 --gid 1000 --shell /bin/bash -o gv \
    && mkdir -p /app /var/lib/games-vault /srv/storage/games-vault /srv/storage/games \
    && chown -R gv:gv /app /var/lib/games-vault /srv/storage/games-vault /srv/storage/games

WORKDIR /app
COPY --from=build /out/ ./
RUN chown -R gv:gv /app

# Libretro cores (nosebleed binary mounted as volume at runtime)
RUN mkdir -p /opt/nosebleed /srv/storage/games-vault/nosebleed/cores
COPY build/cores/*.so /srv/storage/games-vault/nosebleed/cores/
RUN chown -R gv:gv /opt/nosebleed /srv/storage/games-vault/nosebleed

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DataProtection__KeyRingPath=/var/lib/games-vault/dp-keys \
    Nosebleed__AuthSecretPath=/var/lib/games-vault/nosebleed-auth-secret

EXPOSE 8080
VOLUME ["/var/lib/games-vault", "/srv/storage/games-vault", "/srv/storage/games"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

USER gv
ENTRYPOINT ["./games-vault"]
