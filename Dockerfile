FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/

# Install only runtime deps. (Root has only dev deps; server has runtime deps.)
RUN npm ci --omit=dev

# Copy app source.
COPY client ./client
COPY server ./server
COPY README.md ZERO_MEMORY_MANIFESTO.md THREAT_MODEL.md PERFORMANCE_HARDENING_CHECKLIST.md ./ 

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]

