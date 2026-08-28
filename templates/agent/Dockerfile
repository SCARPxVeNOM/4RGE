# For hosts that prefer a Dockerfile to Nixpacks. Either works.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["npm", "start"]
