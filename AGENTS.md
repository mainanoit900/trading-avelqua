# Agent instructions (trading-avelqua)

## หลังแก้โค้ด — deploy Linux ทันที

1. Commit + `git push origin main` (ไม่ commit `.env`, `deploy.env`)
2. รันบนเซิร์ฟเวอร์ production:
   ```bash
   cd /root/trading-avelqua && bash scripts/git-pull-deploy.sh
   ```
3. แจ้งผู้ใช้ผลลัพธ์ (commit, pm2, agent deploy)
