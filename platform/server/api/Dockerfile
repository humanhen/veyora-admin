FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Copy the manifest AND the lockfile, then install strictly from the lockfile.
# `npm ci` fails outright when package.json and package-lock.json disagree, so a
# rebuild of a given commit always produces the same dependency tree — the point
# of committing the lockfile. (`npm install` would silently re-resolve semver
# ranges, so the same commit could ship different code on different days.)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
EXPOSE 3000
CMD ["node", "src/index.js"]
