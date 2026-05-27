//+------------------------------------------------------------------+
//| AvelquaBotClose.mqh — halt close (ใช้ร่วมกับ AK-SNIPER / EA หลัก)      |
//| Agent เขียน bot_close.txt หรือ gate OFF → ปิดทุก position            |
//+------------------------------------------------------------------+
#ifndef AVELQUA_BOT_CLOSE_MQH
#define AVELQUA_BOT_CLOSE_MQH

#include <Trade/Trade.mqh>

static CTrade g_avq_close_trade;
static bool     g_avq_close_timer = false;

string AvqTrimStr(string s)
  {
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
  }

bool AvqReadTextFile(const string name, string &out, const bool use_common)
  {
   out = "";
   int flags = FILE_READ | FILE_TXT | FILE_ANSI;
   if(use_common)
      flags |= FILE_COMMON;
   int h = FileOpen(name, flags);
   if(h == INVALID_HANDLE)
      return false;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      if(StringLen(out) > 0)
         out += "\n";
      out += line;
     }
   FileClose(h);
   out = AvqTrimStr(out);
   return (StringLen(out) > 0);
  }

bool AvqWriteTextFile(const string name, const string body, const bool use_common)
  {
   int flags = FILE_WRITE | FILE_TXT | FILE_ANSI;
   if(use_common)
      flags |= FILE_COMMON;
   int h = FileOpen(name, flags);
   if(h == INVALID_HANDLE)
      return false;
   FileWriteString(h, body);
   FileClose(h);
   return true;
  }

bool AvqIsTruthy(const string s)
  {
   string u = s;
   StringToUpper(u);
   if(u == "1" || u == "TRUE" || u == "ON" || u == "YES")
      return true;
   if(StringFind(u, "CLOSE") >= 0)
      return true;
   return (StringLen(AvqTrimStr(s)) > 0 && u != "0" && u != "FALSE" && u != "OFF" && u != "NO");
  }

bool IsAvelquaTradingEnabled()
  {
   string s = "";
   if(!AvqReadTextFile("avelqua_trading_enabled.txt", s, false))
      AvqReadTextFile("avelqua_trading_enabled.txt", s, true);
   if(StringLen(s) == 0)
      return false;
   string u = s;
   StringToUpper(u);
   return (u == "1" || u == "TRUE" || u == "ON" || u == "YES");
  }

bool AvqShouldForceCloseAll()
  {
   string s = "";
   if(AvqReadTextFile("bot_close.txt", s, false) && AvqIsTruthy(s))
      return true;
   if(AvqReadTextFile("bot_close.txt", s, true) && AvqIsTruthy(s))
      return true;
   if(!IsAvelquaTradingEnabled() && PositionsTotal() > 0)
      return true;
   return false;
  }

void AvqClearBotCloseSignal()
  {
   AvqWriteTextFile("bot_close.txt", "0", false);
   AvqWriteTextFile("bot_close.txt", "0", true);
  }

int AvqCloseAllAccountPositions(const int slippage_points = 120)
  {
   g_avq_close_trade.SetDeviationInPoints(slippage_points);
   g_avq_close_trade.SetAsyncMode(false);
   int closed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      if(g_avq_close_trade.PositionClose(ticket))
         closed++;
      else
         Print("AvelquaBotClose failed ticket=", ticket, " ret=", g_avq_close_trade.ResultRetcode(),
               " ", g_avq_close_trade.ResultRetcodeDescription());
     }
   return closed;
  }

void AvqWriteBotCloseDone(const int closed_count, const int remaining)
  {
   string body = StringFormat("ok=1\nclosed=%d\nremaining=%d\nts=%I64d\nlogin=%I64d\n",
                              closed_count, remaining, (long)TimeCurrent(),
                              AccountInfoInteger(ACCOUNT_LOGIN));
   AvqWriteTextFile("bot_close_done.txt", body, false);
   AvqWriteTextFile("bot_close_done.txt", body, true);
  }

// คืน true = หยุด OnTick หลัก (เพิ่งปิดหรือกำลัง halt)
bool AvelquaBotClosePoll()
  {
   if(!AvqShouldForceCloseAll())
      return false;
   int before = PositionsTotal();
   if(before <= 0)
     {
      AvqClearBotCloseSignal();
      AvqWriteBotCloseDone(0, 0);
      return true;
     }
   Print("AvelquaBotClose: halt — closing ", before, " position(s)");
   int closed = AvqCloseAllAccountPositions();
   int remaining = PositionsTotal();
   AvqWriteBotCloseDone(closed, remaining);
   AvqClearBotCloseSignal();
   Print("AvelquaBotClose: closed=", closed, " remaining=", remaining);
   return true;
  }

void AvelquaBotCloseOnInit()
  {
   if(!g_avq_close_timer)
     {
      EventSetTimer(1);
      g_avq_close_timer = true;
     }
   AvelquaBotClosePoll();
  }

void AvelquaBotCloseOnDeinit()
  {
   if(g_avq_close_timer)
     {
      EventKillTimer();
      g_avq_close_timer = false;
     }
  }

#endif
