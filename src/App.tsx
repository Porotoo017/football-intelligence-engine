import React, { useState, useEffect } from 'react';
import { Activity, RefreshCw, Download, AlertTriangle } from 'lucide-react';

interface MatchPrediction {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeShield: string;
  awayShield: string;
  probabilityHome: number;
  probabilityAway: number;
  recommendedBet: string;
  odds: number;
}

export default function App() {
  const [matches, setMatches] = useState<MatchPrediction[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Ingesta inicial de datos en tiempo real
    const mockData: MatchPrediction[] = [
      {
        id: 'm-1',
        homeTeam: 'River Plate',
        awayTeam: 'Boca Juniors',
        homeShield: 'https://upload.wikimedia.org/wikipedia/commons/a/ac/Escudo_del_C._A._River_Plate.svg',
        awayShield: 'https://upload.wikimedia.org/wikipedia/commons/4/4c/CABJ_logo_2018.svg',
        probabilityHome: 48.5,
        probabilityAway: 23.5,
        recommendedBet: 'Gana River Plate (DNB)',
        odds: 1.72
      }
    ];
    setMatches(mockData);
    setLoading(false);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
      <header className="max-w-4xl mx-auto flex justify-between items-center border-b border-zinc-800 pb-4">
        <h1 className="text-xl font-bold text-emerald-400 flex items-center gap-2">
          <Activity className="w-5 h-5 animate-pulse" /> Football AI Engine
        </h1>
        <button className="bg-emerald-600 px-3 py-1 rounded text-sm font-medium">Descargar APK</button>
      </header>
      <main className="max-w-4xl mx-auto mt-6">
        {matches.map(m => (
          <div key={m.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-4">
            <div className="flex justify-between items-center">
              <img src={m.homeShield} className="w-10 h-10" referrerPolicy="no-referrer" />
              <span className="font-bold">VS</span>
              <img src={m.awayShield} className="w-10 h-10" referrerPolicy="no-referrer" />
            </div>
            <p className="mt-4 text-emerald-400 font-bold">Recomendación: {m.recommendedBet}</p>
          </div>
        ))}
      </main>
    </div>
  );
}
