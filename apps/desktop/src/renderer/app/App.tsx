import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HealthBar } from '../components/HealthBar';
import { Sidebar } from '../components/Sidebar';
import { AuthGate } from '../screens/AuthGate';
import { OverviewScreen } from '../screens/Overview';
import { ShadowPortfolioScreen } from '../screens/ShadowPortfolio';
import { PositionsScreen } from '../screens/Positions';
import { DecisionJournalScreen } from '../screens/DecisionJournal';
import { ResearchUniverseScreen } from '../screens/ResearchUniverse';
import { FingerprintsScreen } from '../screens/Fingerprints';
import { RegimesScreen } from '../screens/Regimes';
import { PortfolioRiskScreen } from '../screens/PortfolioRisk';
import { MicrostructureScreen } from '../screens/Microstructure';
import { ContextScreen } from '../screens/Context';
import { ValidationLabScreen } from '../screens/ValidationLab';
import { CostsAttributionScreen } from '../screens/CostsAttribution';
import { ProtectionScreen } from '../screens/Protection';
import { ReconciliationScreen } from '../screens/Reconciliation';
import { IncidentsScreen } from '../screens/Incidents';
import { ReportsScreen } from '../screens/Reports';
import { ConfigurationScreen } from '../screens/Configuration';
import { SystemScreen } from '../screens/System';
import { SafetyScreen } from '../screens/Safety';

/**
 * Phase 3A §H — Root router.
 *
 * Renders the persistent health bar + sidebar chrome around each
 * screen. Uses HashRouter because the renderer loads from a
 * `file://` URL under Electron.
 */

export function App() {
  return (
    <AuthGate>
      <HashRouter>
        <div className="app">
          <HealthBar />
          <Sidebar />
          <main className="content">
            <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewScreen />} />
            <Route path="/shadow-portfolio" element={<ShadowPortfolioScreen />} />
            <Route path="/positions" element={<PositionsScreen />} />
            <Route path="/decision-journal" element={<DecisionJournalScreen />} />
            <Route path="/research/universe" element={<ResearchUniverseScreen />} />
            <Route path="/research/fingerprints" element={<FingerprintsScreen />} />
            <Route path="/research/regimes" element={<RegimesScreen />} />
            <Route path="/research/portfolio-risk" element={<PortfolioRiskScreen />} />
            <Route path="/research/microstructure" element={<MicrostructureScreen />} />
            <Route path="/research/context" element={<ContextScreen />} />
            <Route path="/research/validation-lab" element={<ValidationLabScreen />} />
            <Route path="/ops/costs-attribution" element={<CostsAttributionScreen />} />
            <Route path="/ops/protection" element={<ProtectionScreen />} />
            <Route path="/ops/reconciliation" element={<ReconciliationScreen />} />
            <Route path="/ops/incidents" element={<IncidentsScreen />} />
            <Route path="/ops/reports" element={<ReportsScreen />} />
            <Route path="/system/configuration" element={<ConfigurationScreen />} />
            <Route path="/system" element={<SystemScreen />} />
            <Route path="/safety" element={<SafetyScreen />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </AuthGate>
  );
}
