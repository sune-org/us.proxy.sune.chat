FROM oven/bun:1-slim
WORKDIR /app
COPY package.json ./
RUN bun install --production --no-save
COPY . .
EXPOSE 3000
CMD ["bun", "run", "index.js"]
