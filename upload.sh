rm -rf dist
npm run build

scp -r /Users/zhangzhiwei/Desktop/code/copy/nest/package.json root@82.157.111.208:/app/backend/package.json

scp -r /Users/zhangzhiwei/Desktop/code/copy/nest/package-lock.json root@82.157.111.208:/app/backend/package-lock.json

scp -r /Users/zhangzhiwei/Desktop/code/copy/nest/dist/* root@82.157.111.208:/app/backend/dist/

scp -r /Users/zhangzhiwei/Desktop/code/copy/nest/certs/* root@82.157.111.208:/app/backend/certs/

scp -r /Users/zhangzhiwei/Desktop/code/copy/nest/.env root@82.157.111.208:/app/backend/.env

scp -r /Users/zhangzhiwei/Desktop/code/copy/nest/scripts/* root@82.157.111.208:/app/backend/scripts/

