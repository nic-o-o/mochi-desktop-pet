# Mochi's draw server (server/). Node with no npm dependencies, so the image
# holds only the server and the three app modules it shares.
#
#   docker build -f server/Dockerfile -t mochi-draw .
#
# Configuration is all environment (see server/main.mjs); in AWS the Model API
# key arrives as MODEL_API_KEY from Secrets Manager.
FROM node:22-alpine
WORKDIR /app
COPY electron/petGenerator.mjs electron/looks.mjs electron/clerkConfig.mjs ./electron/
COPY server/ ./server/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "server/main.mjs"]
