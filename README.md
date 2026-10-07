# MinIO Community trên VPS: storage dùng chung cho nhiều backend

Bộ này chạy image Docker Hub `minio/minio:RELEASE.2025-09-07T16-13-09Z`, dùng Traefik Docker network `web`, entrypoint HTTPS `websecure`, certresolver `le`. S3 API public: `https://cdn.dangngochai.io.vn`; Console chỉ mở ở loopback VPS và truy cập bằng SSH tunnel. **Không cần license AIStor.**

> Trạng thái hiện tại: dự án MinIO Community đã ngừng bảo trì; Docker Hub image cố định ở bản lịch sử và không nhận bản vá mới. Kiểm tra khả năng pull trên VPS và cân nhắc rủi ro này nếu lưu file quan trọng. Không đưa volume của bản AIStor vào image này hoặc chạy hai stack cùng domain.

Luồng: frontend xin URL từ Express → Express cấp URL ký 5 phút → frontend `PUT` file trực tiếp tới MinIO → Express `HEAD` xác minh và ghi object key vào DB. Binary file không truyền qua Express.

## 1. Chuẩn bị VPS

- DNS `cdn.dangngochai.io.vn` trỏ tới VPS; Traefik đang dùng external Docker network `web`, entrypoint `websecure`, certresolver `le`.
- Chọn ổ đĩa bền vững đủ dung lượng cho `DATA_DIR`. Nếu đã có MinIO phục vụ domain này, dùng hạ tầng sẵn có hoặc lập kế hoạch chuyển đổi; không chạy đồng thời hai router cùng Host.
- Không dùng chung thư mục `data` với AIStor hoặc một instance MinIO khác. Backup dữ liệu hiện có trước khi đổi instance.

```bash
cd minio-community-vps
docker network inspect web
docker pull minio/minio:RELEASE.2025-09-07T16-13-09Z
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Sửa `.env`: `MINIO_ROOT_USER` là tài khoản quản trị riêng; `MINIO_ROOT_PASSWORD` dùng chuỗi ngẫu nhiên vừa tạo; `DATA_DIR` theo ổ đĩa thực tế. Điền **tất cả frontend origin** dùng chung storage vào `MINIO_API_CORS_ALLOW_ORIGIN`, cách nhau bằng dấu phẩy, có `https://`, không có đường dẫn hoặc dấu `/` cuối. CORS bản Community áp dụng toàn server, không theo bucket. Danh sách CORS chỉ cho phép trình duyệt gọi API; bucket policy và URL ký mới quyết định quyền truy cập.

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
docker compose --env-file .env logs --tail=80 storage-minio
curl -i https://cdn.dangngochai.io.vn/minio/health/live
```

Nếu `127.0.0.1:9001` đã có service khác, sửa cổng bên trái trong `compose.yml`, ví dụ `127.0.0.1:19001:9001`. Port S3 9000 không public trực tiếp; Traefik kết nối tới 9000 qua `web`. Không gắn middleware Traefik làm thay đổi Host/path/query của signed URL.

## 2. Công cụ `mc` và Console quản trị

Trên VPS Linux amd64 (ARM64 đổi đường dẫn `linux-amd64` thành `linux-arm64`):

```bash
curl -fL https://dl.min.io/client/mc/release/linux-amd64/mc -o mc
chmod +x mc
sudo mv mc /usr/local/bin/mc
mc --version
read -r -p 'Root user: ' ROOT_USER
read -r -s -p 'Root password: ' ROOT_PASSWORD
printf '\n'
mc alias set minio-vps https://cdn.dangngochai.io.vn "$ROOT_USER" "$ROOT_PASSWORD"
unset ROOT_PASSWORD
mc admin info minio-vps
```

Alias `mc` lưu credential trong tài khoản hệ điều hành VPS; chỉ admin có quyền đọc cấu hình này. Backend dùng user riêng, không dùng root.

Trên máy cá nhân:

```bash
ssh -L 9001:127.0.0.1:9001 -p <SSH_PORT> <SSH_USER>@<VPS_IP>
```

Sau đó mở `http://127.0.0.1:9001` trên máy cá nhân. Nếu dùng 19001 ở VPS, thay phần đích tunnel thành `127.0.0.1:19001`. Tác vụ quản lý bucket, user, policy, quota dùng `mc`; giao diện Console của các bản Community cũ có thể không có đầy đủ mục quản trị.

## 3. User và bucket cho từng backend

Mỗi dự án/môi trường có một bucket và một user, ví dụ:

| Backend | Bucket | User | Phạm vi policy |
| --- | --- | --- | --- |
| news production | `news-prod` | `app-news-prod` | Chỉ `news-prod` |
| news development | `news-dev` | `app-news-dev` | Chỉ `news-dev` |

```bash
chmod +x scripts/onboard-backend.sh
./scripts/onboard-backend.sh news-prod news-prod 20GB
./scripts/onboard-backend.sh news-dev news-dev 5GB
```

Script tạo bucket, policy tối thiểu và user; in secret đúng một lần. Chép secret vào file env riêng của **backend** và không commit. Policy mẫu cho phép Get/Put/Delete object và ListBucket/GetBucketLocation của đúng bucket. Nếu không xóa qua API, bỏ `s3:DeleteObject` trong `policies/backend-bucket.template.json` trước khi onboard. Script dừng nếu user đã tồn tại để tránh đổi secret ngoài ý muốn. `mc admin bucket quota --hard` là quota dung lượng của Community; quota được tính theo chu kỳ và có thể tạm vượt trước khi MinIO cập nhật số liệu.

Kiểm tra policy và user:

```bash
mc admin policy info minio-vps bucket-news-prod
mc admin user info minio-vps app-news-prod
mc admin bucket quota minio-vps/news-prod
```

Kiểm tra chéo bằng user production: `mc ls <alias-prod>/news-dev` phải trả `AccessDenied`. Nếu thêm backend, chạy script với APP_NAME/BUCKET mới; bucket không có quyền public và backend không nhận credential root.

## 4. Express cấp URL, frontend upload thẳng

`examples/backend.env.example` chứa các env **cho một backend**. `S3_PUBLIC_ENDPOINT=https://cdn.dangngochai.io.vn` dùng để ký URL trả cho frontend. `S3_INTERNAL_ENDPOINT=http://storage-minio:9000` dùng để xác minh file khi backend container cùng Docker network `web`; nếu backend ở máy khác thì dùng endpoint HTTPS public cho cả hai. Không thay hostname của presigned URL sau khi ký.

Gắn backend container vào network `web` nếu muốn dùng endpoint nội bộ:

```yaml
services:
  backend:
    networks: [web]
networks:
  web:
    external: true
```

Trong backend `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`; dùng các hàm ở `examples/presigned-upload.mjs` sau middleware auth của ứng dụng:

1. API `POST /files/presign`: xác thực user, cấp key do server sinh, lưu bản ghi pending trong DB; trả `uploadUrl`, method `PUT`, header Content-Type.
2. Frontend: `fetch(uploadUrl, { method: 'PUT', headers, body: file })`. Gửi **file**, không gửi `FormData` với presigned PUT.
3. API `POST /files/complete`: xác thực user, tra pending, gọi HEAD, kiểm kích thước/MIME, hoàn tất DB. Xóa pending/object mồ côi sau khi hết hạn.
4. File riêng tư: sau khi kiểm quyền DB, backend tạo presigned GET ngắn hạn. DB chỉ lưu object key, không lưu URL ký.

Giới hạn kích thước trong ví dụ là **hậu kiểm**, vì presigned PUT không ngăn việc client gửi file quá lớn. Nếu cần chặn trước khi gửi, triển khai presigned POST với điều kiện kích thước và kiểm chứng với đúng bản MinIO đang chạy. Bật rate limit ở API cấp URL và giới hạn dung lượng theo user.

## 5. Backup và lỗi thường gặp

- Backup object sang VPS/S3 **khác** qua `mc mirror`, giữ riêng env, credential, policy và ghi lại cách khôi phục. Một VPS là một điểm lỗi; kiểm tra khôi phục bằng một bucket thử.
- `SignatureDoesNotMatch`: kiểm domain public trong URL, Content-Type đã ký, redirect ở Traefik, đồng hồ VPS và path-style S3.
- CORS: kiểm `MINIO_API_CORS_ALLOW_ORIGIN` trong `.env`, đã recreate container sau khi sửa, frontend origin có đúng scheme/port không; đừng thử `mc cors set`, Community không hỗ trợ CORS theo bucket.
- `AccessDenied`: kiểm đúng bucket/user/policy; dùng root để xác minh cấu hình, không gắn root vào backend.
- Dừng container không xoá dữ liệu: `docker compose down` giữ data bind mount; không tự ý xoá thư mục data. Backup trước mọi thay đổi image.

Nguồn tham khảo: https://github.com/minio/minio ; https://github.com/minio/minio/discussions/20841 ; https://github.com/minio/minio/blob/master/docs/config/README.md ; https://github.com/minio/minio/blob/master/docs/bucket/quota/README.md
