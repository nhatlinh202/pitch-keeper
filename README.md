# Pitch Keeper — Premiere Pro 25.6+ (macOS)

Panel giữ cho voice đúng pitch mong muốn dù bạn speed up / slow down clip.
Mỗi clip trên các **track VO** được plugin quản lý 2 lớp **Pitch Shifter**:

| Lớp | Giá trị | Mục đích |
|---|---|---|
| #1 Master | Master Pitch chung cho mọi VO của project (trống = ×1.0, bypass) | Đổi pitch có chủ đích cho giọng đọc |
| #2 Speed | `1 / speed` | Bù lại pitch bị lệch do đổi speed |

Pitch nghe được = F0 gốc × Master, bất kể speed. Ví dụ Master 0.9, speed 125% → #1 ×0.9, #2 ×0.8 (tổng ×0.72).

## Cài đặt (macOS, Premiere Pro 25.6+)

Chọn **một** trong hai cách:

**Cách 1 — bấm đúp (không cần Terminal)**
1. Tải [`PitchKeeper.pkg`](https://github.com/nhatlinh202/pitch-keeper/releases/latest/download/PitchKeeper.pkg).
2. Bấm đúp → Continue → Install.
3. Nếu macOS báo không mở được vì không xác minh được nhà phát triển:
   **System Settings › Privacy & Security** → kéo xuống → **Open Anyway** → nhập mật khẩu máy → mở lại file `.pkg`.

**Cách 2 — Terminal**
```bash
curl -fsSL https://github.com/nhatlinh202/pitch-keeper/releases/latest/download/install.sh | bash
```

Sau khi cài: khởi động lại Premiere → **Window › Extensions › Pitch Keeper**.

### Cập nhật
Không cần làm gì. Panel tự kiểm tra bản mới khi mở và mỗi 6 giờ, tải về, kiểm tra sha256 rồi tự tải lại.
Nút con bọ có **Kiểm tra cập nhật** và **Quay về bản trước**. Cài đặt của bạn (Master, track VO, ON/OFF) được giữ nguyên.

## Sử dụng

- **Công tắc ON/OFF** (góc trên bên phải) lưu riêng cho **từng sequence**, mặc định OFF.
  Tool chỉ tác động lên sequence đang mở trên timeline, không bao giờ mở hay sửa sequence khác.
  - ON: quét các track VO của sequence đang mở mỗi 1.5 giây, clip nào lệch thì tự thêm / cập nhật 2 lớp.
  - OFF: chỉ trong sequence đang mở — xoá các Pitch Shifter do tool thêm và trả lại giá trị cũ cho Pitch Shifter tool đã ghi đè.
    Nếu Premiere không cho xoá, lớp đó được đặt ×1.0 + bypass (log báo rõ).
- **ⓘ** (góc trên bên trái): trạng thái quét + phân tích clip đang chọn.
- **Nút con bọ**: cài đặt quét, tham số effect, QE methods, Copy log để gửi khi cần sửa lỗi.
- **Master Pitch (mọi VO)**: một ratio 0.5 – 2.0 (vd `0.9`) cho mọi clip VO, lưu theo project. Để trống nếu không đổi.
- **Track chứa VO**: tick các track có VO (chọn được nhiều track), lưu theo từng sequence.
  Lần đầu mở sequence, track có tên chứa VO / Voice / Narration / Thoại được tự chọn.
  Bỏ tick track, hoặc kéo clip sang track không phải VO → tool gỡ các lớp nó đã thêm trên clip đó.
  BGM, SFX trên track không tick không bao giờ bị đụng tới.
- Đoạn cắt bằng Razor hoặc clip nhân bản thừa hưởng 2 lớp từ clip gốc được tool tự nhận là của nó, nên OFF vẫn gỡ được.

## Lưu ý

- Plugin sở hữu **2 Pitch Shifter đầu tiên** trên mỗi clip và sẽ ghi đè chúng.
  Pitch Shifter bạn tự thêm phải nằm ở vị trí thứ 3 trở đi thì plugin không đụng tới.
- Lớp có ratio 1.0 được bật bypass để không xử lý âm thanh.
- Mỗi lớp chỉ trong khoảng ×0.5–×2.0 (speed 50%–200%); ngoài khoảng đó lớp #2 bị kẹp.
- Formant Preserve không được script hỗ trợ; nếu cần, chỉnh tay trong Custom Setup của effect.
- Việc thêm effect dùng QE DOM (API nội bộ, không có tài liệu chính thức) của Premiere.
- Mỗi lần tự áp dụng là một bước Undo. Panel phải đang mở (docked ở tab nền cũng được).
- Danh sách clip do tool đã chỉnh được lưu trên máy này; Pitch Shifter do các bản trước thêm không nằm trong danh sách nên OFF không gỡ.
- `ffmpeg` (Homebrew) chỉ dùng để đo F0 trong ⓘ; máy không có ffmpeg vẫn chạy bằng Web Audio.

## Phát hành bản mới (người bảo trì)

```bash
./release.sh 1.0.1 "Ghi chú thay đổi"
```

Script ghi `PitchKeeper/VERSION`, đóng gói `PitchKeeper.zip` + `PitchKeeper.pkg` + `version.json` + `install.sh`,
commit, gắn tag `v1.0.1`, push và tạo GitHub Release. Thêm `--dry-run` để chỉ build vào `dist/`.
Cần `gh` đã đăng nhập (`gh auth login`) và `node`.

Thử bản đang sửa trên máy mình: `./dev-install.sh` (chép thẳng thư mục `PitchKeeper/` vào Premiere).

| Đường dẫn | Nội dung |
|---|---|
| `PitchKeeper/` | Extension CEP (manifest, panel, ExtendScript, trình cập nhật) |
| `scripts/install.sh` | Bộ cài bằng Terminal, được đính kèm vào mỗi Release |
| `scripts/pkg/postinstall` | Chạy sau khi cài `.pkg`: chép extension vào `~/Library` của người dùng, bật PlayerDebugMode |
