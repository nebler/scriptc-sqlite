# links on Vercel's container runtime: build the native binary with scriptc,
# then ship only the binary and a seeded database on a slim base image.
#
# The build stage takes the code from GitHub at REF, so the image is built
# from a commit anyone can check out.
FROM node:24-trixie AS build
ARG REF=main
RUN apt-get update && apt-get install -y --no-install-recommends clang unzip ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/nebler/scriptc-sqlite /src && git -C /src checkout --detach "$REF"
WORKDIR /src
RUN npm ci --no-audit --no-fund
WORKDIR /src/demo/server
RUN npm install --no-audit --no-fund && npm run build && ./build/links --seed /tmp/seed.db && ls -l build/links /tmp/seed.db

FROM debian:trixie-slim
COPY --from=build /src/demo/server/build/links /app/links
COPY --from=build /tmp/seed.db /app/seed.db
ENV PORT=80 DB_PATH=/tmp/links.db SEED_DB=/app/seed.db
EXPOSE 80
CMD ["/app/links"]
