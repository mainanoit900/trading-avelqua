# AK-SNIPER ↔ ตาราง Admin `/admin/mt5-presets/ak-sniper`

## สรุป (ไม่แก้ไฟล์ `.mq5`)

| ชั้น | ทำอะไรได้ |
|------|-----------|
| **ตาราง admin** | ทุน, LOT, LOT PLUS, T START/STOP ตามระดับความเสี่ยง |
| **ระบบเว็บ (`lib/mt5EaSet.js`)** | สร้างไฟล์ `.set` ส่งไป VPS ตอน Run BOT |
| **Agent** | เขียน `.set` ลง `MQL5/Presets` + โฟลเดอร์ EA |
| **MT5** | แนบ EA → Load preset → เปิด Algo Trading |

## แมปคอลัมน์ตาราง → Input ของ EA

| คอลัมน์ admin | Input ใน EA | หมายเหตุ |
|---------------|-------------|----------|
| `lot_size` | `InpLotSize` | Lot ไม้แรก |
| `lot_plus` | `InpLotPlus` | บวก lot แก้ไม้ |
| `t_start` / `t_stop` | `InpTrailingStartMoney` / `InpTrailingStopMoney` | ระดับ **เสี่ยงสูง** |
| `medium_t_start` / `medium_t_stop` | เดียวกัน | ระดับ **เสี่ยงกลาง** |
| `fast_t_start` / `fast_t_stop` | เดียวกัน | ระดับ **เสี่ยงต่ำ** |
| `pip_step` (ใหม่) | `InpPipStep` | ค่าเริ่มต้น 345 |
| `take_profit_average` (ใหม่) | `InpTakeProfitAverage` | ค่าเริ่มต้น 100 |

## สิ่งที่ปรับจากตาราง admin **ไม่ได้** (ฝังใน `.ex5`)

- `AllowedAccounts[]` — เฉพาะเลขที่ระบุใน source (201200179–185)
- วันหมดอายุ `InpExpiryDate`
- โบรกเกอร์ (XM / Mohicans Markets)
- ฟิลเตอร์เวลา / ADX / ข่าว (ต้องตั้งใน MT5 Inputs เอง)

## ขั้นตอนให้ MT5 เปิด BOT ได้

1. บัญชี MT5 ต้องอยู่ในรายการที่ EA อนุญาต (หรือใช้ `.ex5` ที่ผู้พัฒนาออกให้บัญชีนั้น)
2. โบรกเกอร์ Mohicans / XM
3. กราฟ **XAUUSD** + แนบ **AK-SNIPER-VIP-VER4.0**
4. **Inputs → Load** ไฟล์ `Avelqua_AK-SNIPER-VIP-VER4.0_<level>_<capital>.set` (ระบบสร้างให้)
5. ปุ่ม **Algo Trading สีเขียว**
