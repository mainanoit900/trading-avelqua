-- ตัวอย่าง seed VPS/PORT
-- แก้ node_code, token, path ให้ตรงของจริงก่อนรัน

INSERT INTO vps_system.vps_nodes(node_code, display_name, agent_token, base_path, max_ports, enabled)
VALUES ('VPS-WIN-01', 'VPS Windows 01', 'avelqua-vps-2026', 'C:\MT5_PORTS', 6, TRUE)
ON CONFLICT (node_code) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  agent_token=EXCLUDED.agent_token,
  base_path=EXCLUDED.base_path,
  max_ports=EXCLUDED.max_ports,
  enabled=EXCLUDED.enabled;

INSERT INTO vps_system.vps_ports(vps_id, port_no, port_name, folder_path, enabled, status)
SELECT n.id, gs, 'PORT_' || LPAD(gs::TEXT, 2, '0'), n.base_path || '\PORT_' || LPAD(gs::TEXT, 2, '0'), TRUE, 'free'
FROM vps_system.vps_nodes n
CROSS JOIN generate_series(1, 6) gs
WHERE n.node_code='VPS-WIN-01'
ON CONFLICT (vps_id, port_no) DO UPDATE SET
  port_name=EXCLUDED.port_name,
  folder_path=EXCLUDED.folder_path,
  enabled=EXCLUDED.enabled;
