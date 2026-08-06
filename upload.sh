rm -rf dist
npm run build

scp -r /Users/lufy/Desktop/ff/nest/package.json root@82.157.111.208:/app/backend/package.json

scp -r /Users/lufy/Desktop/ff/nest/package-lock.json root@82.157.111.208:/app/backend/package-lock.json

scp -r /Users/lufy/Desktop/ff/nest/dist/* root@82.157.111.208:/app/backend/dist/

scp -r /Users/lufy/Desktop/ff/nest/certs/* root@82.157.111.208:/app/backend/certs/

scp -r /Users/lufy/Desktop/ff/nest/.env root@82.157.111.208:/app/backend/.env

scp -r /Users/lufy/Desktop/ff/nest/scripts/* root@82.157.111.208:/app/backend/scripts/

