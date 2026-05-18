//+------------------------------------------------------------------+
//| AvelquaEquityPulse.mq5 — ส่ง Balance/Equity ให้เว็บ AVELQUA      |
//| แนบบนชาร์ทใดก็ได้ (แนะนำ XAUUSD) แล้วเปิด AutoTrading            |
//+------------------------------------------------------------------+
#property copyright "Avelqua"
#property version   "1.00"
#property indicator_chart_window
#property indicator_buffers 0
#property indicator_plots   0

int OnInit()
  {
   EventSetTimer(2);
   WriteAccount();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const string reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   WriteAccount();
  }

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
  {
   WriteAccount();
   return(rates_total);
  }

void WriteAccount()
  {
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   double pr  = AccountInfoDouble(ACCOUNT_PROFIT);
   string cur = AccountInfoString(ACCOUNT_CURRENCY);
   long login = AccountInfoInteger(ACCOUNT_LOGIN);

   string body = StringFormat(
      "login=%I64d\nbalance=%.2f\nequity=%.2f\nprofit=%.2f\ncurrency=%s\nts=%I64d\n",
      login, bal, eq, pr, cur, (long)TimeCurrent()
   );

   int h = FileOpen("avelqua_account.txt", FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h == INVALID_HANDLE)
      return;
   FileWriteString(h, body);
   FileClose(h);
  }
