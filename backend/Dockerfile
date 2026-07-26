# Otto backend — Fastify API + LangGraph engine, run via tsx (no separate compile step).
FROM node:24-slim
WORKDIR /app

# install deps (tsx + runtime); package-lock optional
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ENV PORT=8010
EXPOSE 8010

# env (SIGNOZ_URL, SIGNOZ_MCP_URL, SIGNOZ_API_KEY, OPENAI_API_KEY, OTTO_OTEL, OTEL_EXPORTER_OTLP_ENDPOINT)
# is supplied by docker-compose (env_file / environment) — never baked into the image.
CMD ["npx", "tsx", "src/server.ts"]
