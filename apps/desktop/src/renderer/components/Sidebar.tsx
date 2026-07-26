import { NavLink } from 'react-router-dom';
import { PRIMARY_NAVIGATION, navGroupsInOrder } from '../../shared/navigation';

/**
 * Phase 3A §H — Persistent sidebar. NOT copied from the mobile
 * navigation.
 */

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Primary navigation">
      {navGroupsInOrder().map((group) => (
        <div key={group}>
          <div className="group">{group.replace('_', ' ')}</div>
          {PRIMARY_NAVIGATION.filter((n) => n.group === group).map((item) => (
            <NavLink
              key={item.key}
              to={item.route}
              className={({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}
