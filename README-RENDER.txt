OMKAR COURIER SERVICES — RENDER TEST DEPLOYMENT

1. This folder is the project root: it contains package.json, server.js and Dockerfile.
2. Upload this folder's CONTENTS to a NEW GitHub repository (not your other project repositories).
3. In Render choose New + > Web Service, connect the new repository.
4. Select Docker as the runtime if asked. Render should detect Dockerfile.
5. Choose a service name, select the Free instance type if available, then click Create Web Service.
6. Wait for the build and deployment to finish. Open the https://<service-name>.onrender.com URL shown by Render.

IMPORTANT TEST LIMITATIONS
- This is a test deployment. Free Render services can sleep when idle and their local filesystem is ephemeral; SQLite data may be lost after restart/redeploy. Do not use it for real customer records until persistent/managed database storage is configured.
- Tracking sites can block automated browser requests, change their pages, or require CAPTCHA. A successful website deployment does not guarantee every courier's live tracking will work.
- DHL live tracking is not connected in this project yet.
- The public tracking browser is set to headless mode for server hosting; a CAPTCHA that requires a person cannot be completed in that browser.

Local Windows setup remains: npm install, then npm start, then open http://localhost:3000.
