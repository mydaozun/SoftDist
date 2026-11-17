-- 安装目录：留空时客户端使用默认根目录 C:\APP\<软件名>
ALTER TABLE apps ADD COLUMN install_dir TEXT NOT NULL DEFAULT '';
