import React from 'react'
import { Link } from 'react-router-dom'
import { useIconStyle } from '../icons/IconStyleContext'
import { LoginButton, SettingsButton } from '@degenerates/ui'
import styles from './index.module.scss'

interface SettingsProps {
  onClose?: () => void
}

const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { style, setStyle } = useIconStyle()

  return (
    <SettingsButton onClose={onClose}>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>图标风格</h3>
        <div className={styles.styleToggle}>
          <button
            className={`${styles.styleOption} ${style === 'pixel' ? styles.styleOptionActive : ''}`}
            onClick={() => setStyle('pixel')}
          >
            Pixel
          </button>
          <button
            className={`${styles.styleOption} ${style === 'cyberpunk' ? styles.styleOptionActive : ''}`}
            onClick={() => setStyle('cyberpunk')}
          >
            Cyberpunk
          </button>
          <button
            className={`${styles.styleOption} ${style === 'anime' ? styles.styleOptionActive : ''}`}
            onClick={() => setStyle('anime')}
          >
            Anime
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>服务器</h3>
        <Link to="/server-manager" className={styles.managerLink}>
          管理游戏下载与更新
        </Link>
      </div>

      <LoginButton mode="full" />
    </SettingsButton>
  )
}

export { Settings }
