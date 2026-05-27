//+------------------------------------------------------------------+
//| BOTClose.mq5 — ปิดออเดอร์เมื่อ halt (ไม่ออกออเดอร์ใหม่)              |
//| แนบชาร์ตที่ 2 คู่กับบอทหลัก + เปิด AutoTrading                      |
//+------------------------------------------------------------------+
#property copyright "Avelqua"
#property version   "1.00"
#property description "BOTClose: polls bot_close.txt and closes all positions on halt"

#include <Trade/Trade.mqh>

input int    InpPollSeconds     = 1;
input int    InpSlippagePoints  = 120;
input bool   InpCloseOnGateOff  = true;

CTrade g_trade;

string TrimStr(string s)
  {
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
  }

bool ReadTextFile(const string name, string &out, const bool use_common)
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
   out = TrimStr(out);
   return (StringLen(out) > 0);
  }

bool WriteTextFile(const string name, const string body, const bool use_common)
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

bool IsTruthy(const string s)
  {
   string u = s;
   StringToUpper(u);
   if(u == "1" || u == "TRUE" || u == "ON" || u == "YES")
      return true;
   if(StringFind(u, "CLOSE") >= 0)
      return true;
   return (StringLen(TrimStr(s)) > 0 && u != "0" && u != "FALSE" && u != "OFF" && u != "NO");
  }

bool IsGateOff()
  {
   string s = "";
   if(!ReadTextFile("avelqua_trading_enabled.txt", s, false))
      ReadTextFile("avelqua_trading_enabled.txt", s, true);
   if(StringLen(s) == 0)
      return false;
   string u = s;
   StringToUpper(u);
   return (u == "0" || u == "FALSE" || u == "OFF" || u == "NO");
  }

bool ShouldForceClose()
  {
   string s = "";
   if(ReadTextFile("bot_close.txt", s, false) && IsTruthy(s))
      return true;
   if(ReadTextFile("bot_close.txt", s, true) && IsTruthy(s))
      return true;
   if(InpCloseOnGateOff && IsGateOff() && PositionsTotal() > 0)
      return true;
   return false;
  }

void ClearCloseSignal()
  {
   WriteTextFile("bot_close.txt", "0", false);
   WriteTextFile("bot_close.txt", "0", true);
  }

int CloseAllPositions()
  {
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   g_trade.SetAsyncMode(false);
   int closed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      if(g_trade.PositionClose(ticket))
         closed++;
      else
         Print("BOTClose failed ticket=", ticket, " ret=", g_trade.ResultRetcode(),
               " ", g_trade.ResultRetcodeDescription());
     }
   return closed;
  }

void WriteDoneFile(const int closed_count, const int remaining)
  {
   string body = StringFormat("ok=1\nclosed=%d\nremaining=%d\nts=%I64d\nlogin=%I64d\n",
                              closed_count, remaining, (long)TimeCurrent(),
                              AccountInfoInteger(ACCOUNT_LOGIN));
   WriteTextFile("bot_close_done.txt", body, false);
   WriteTextFile("bot_close_done.txt", body, true);
  }

void PollBotClose()
  {
   if(!ShouldForceClose())
      return;
   int before = PositionsTotal();
   if(before <= 0)
     {
      ClearCloseSignal();
      WriteDoneFile(0, 0);
      return;
     }
   Print("BOTClose: halt signal, positions=", before);
   int closed = CloseAllPositions();
   int remaining = PositionsTotal();
   WriteDoneFile(closed, remaining);
   ClearCloseSignal();
   Print("BOTClose: closed=", closed, " remaining=", remaining);
  }

int OnInit()
  {
   EventSetTimer(MathMax(1, InpPollSeconds));
   PollBotClose();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const string reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   PollBotClose();
  }

void OnTick()
  {
   PollBotClose();
  }
