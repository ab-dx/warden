# one image per service: docker build --build-arg APP=edge-gateway .
FROM node:24-bookworm-slim AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /repo
COPY . .
# installed before APP is read, so every service shares this layer
RUN pnpm install --frozen-lockfile
ARG APP
RUN test -n "$APP" || (echo "pass --build-arg APP=<service>" && exit 1)
# the api also serves the dashboard, so build both for it
RUN pnpm turbo run build --filter="@warden/${APP}..." $( [ "$APP" = api ] && echo --filter=@warden/dashboard )
RUN pnpm deploy --filter="@warden/${APP}" --prod /out \
  && if [ "$APP" = api ]; then cp -r apps/dashboard/dist /out/dashboard; fi \
  && cp docs/policy.example.yaml /out/policy.yaml

FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production
CMD ["dist/main.js"]
