'use strict';

const MT5_LOCKED_SERVER = process.env.MT5_DEFAULT_SERVER || 'MohicansMarkets-Live';
const MT5_LOCKED_COMPANY = 'Mohicans Markets Ltd';
const MT5_SUCCESS_MSG = 'เชื่อมต่อสำเร็จ';
const MT5_FAIL_USER_MSG = 'เชื่อมต่อไม่สำเร็จผู้ใช้งานผิด';

function normalizeLockedServer(serverName) {
  return MT5_LOCKED_SERVER;
}

module.exports = {
  MT5_LOCKED_SERVER,
  MT5_LOCKED_COMPANY,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  normalizeLockedServer
};
