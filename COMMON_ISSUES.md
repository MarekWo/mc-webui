## Common Issues and Solutions

### Issue: Container won't start

**Check logs:**
```bash
docker compose logs meshcore-bridge
docker compose logs mc-webui
```

**Common causes:**
- Serial port not found → Verify MC_SERIAL_PORT in .env
- Permission denied → Add user to dialout group (Step 4)
- Port 5000 already in use → Change FLASK_PORT in .env

### Issue: Cannot access web interface

**Check if port is open:**
```bash
sudo netstat -tulpn | grep 5000
```

**Check firewall:**
```bash
# Allow port 5000 (if using UFW)
sudo ufw allow 5000/tcp
```

**Check container is running:**
```bash
docker compose ps
```

### Issue: No messages appearing

**Verify meshcli is working:**
```bash
# Test meshcli directly in bridge container
docker compose exec meshcore-bridge meshcli -s /dev/ttyUSB0 infos
```

**Check .msgs file:**
```bash
docker compose exec mc-webui cat /root/.config/meshcore/YourDeviceName.msgs
```

Replace `YourDeviceName` with your MC_DEVICE_NAME.

### Issue: USB device errors

**Check device connection:**
```bash
ls -l /dev/serial/by-id/
```

**Restart bridge container:**
```bash
docker compose restart meshcore-bridge
```

**Check device permissions:**
```bash
ls -l /dev/serial/by-id/usb-Espressif*
```

Should show `crw-rw----` with group `dialout`.

## Maintenance Commands

**View logs:**
```bash
docker compose logs -f              # All services
docker compose logs -f mc-webui     # Main app only
docker compose logs -f meshcore-bridge  # Bridge only
```

**Restart services:**
```bash
docker compose restart              # Restart both
docker compose restart mc-webui     # Restart main app only
docker compose restart meshcore-bridge  # Restart bridge only
```

**Stop application:**
```bash
docker compose down
```

**Update to latest version:**
```bash
git pull origin main
docker compose down
docker compose up -d --build
```

**View container status:**
```bash
docker compose ps
```

**Access container shell:**
```bash
docker compose exec mc-webui sh
docker compose exec meshcore-bridge sh
```

## Backup Your Data

**All important data is in the `data/` directory:**

```bash
# Create backup
cd ~/mc-webui
tar -czf ../mc-webui-backup-$(date +%Y%m%d).tar.gz data/

# Verify backup
ls -lh ../mc-webui-backup-*.tar.gz
```

**Recommended backup schedule:**
- Weekly backups of `data/` directory
- Before major updates
- After significant configuration changes

**Restore from backup:**
```bash
# Stop application
cd ~/mc-webui
docker compose down

# Restore data
tar -xzf ../mc-webui-backup-YYYYMMDD.tar.gz

# Restart
docker compose up -d
```

## Next Steps

After successful installation:

1. **Join channels** - Create or join encrypted channels with other users
2. **Configure contacts** - Enable manual approval if desired
3. **Test Direct Messages** - Send DM to other CLI contacts
4. **Set up backups** - Schedule regular backups of `data/` directory
5. **Read full documentation** - See [README.md](README.md) for all features

## Getting Help

**Documentation:**
- Full README: [README.md](README.md)
- MeshCore docs: https://meshcore.org
- meshcore-cli docs: https://github.com/meshcore-dev/meshcore-cli

**Issues:**
- GitHub Issues: https://github.com/MarekWo/mc-webui/issues
- Check existing issues before creating new ones
- Include logs when reporting problems

---

**Version:** 2026-01-06

