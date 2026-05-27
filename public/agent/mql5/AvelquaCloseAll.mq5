//+------------------------------------------------------------------+
//| AvelquaCloseAll.mq5 — close every open position (halt/emergency) |
//+------------------------------------------------------------------+
#property script_show_inputs
#property description "Avelqua emergency close all positions"

#include <Trade/Trade.mqh>

input int SlippagePoints = 120;

void OnStart()
{
   CTrade trade;
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetAsyncMode(false);

   int total = PositionsTotal();
   for (int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if (ticket == 0)
         continue;
      if (!PositionSelectByTicket(ticket))
         continue;
      if (!trade.PositionClose(ticket))
      {
         Print("AvelquaCloseAll failed ticket=", ticket, " ret=", trade.ResultRetcode(),
               " ", trade.ResultRetcodeDescription());
      }
      else
      {
         Print("AvelquaCloseAll closed ticket=", ticket);
      }
   }
}
