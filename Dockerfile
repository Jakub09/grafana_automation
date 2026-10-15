# Obraz WYŁĄCZNIE dla środowiska deweloperskiego (compose.yaml, testy e2e).
# Produkcja działa bez kontenerów - zob. deploy/ i README ("Wdrożenie produkcyjne").
FROM docker.io/library/node:22-bookworm-slim
# gnuplot - wykresy SVG; fonty z polskimi znakami (wykresy, PDF)
RUN apt-get update \
    && apt-get install -y --no-install-recommends gnuplot-nox fonts-dejavu-core fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

EXPOSE 3001
CMD ["node", "dist/server.js"]
