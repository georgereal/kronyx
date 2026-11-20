import React, { useState } from 'react';

const agentsDummy = [
  { id: 'agent1', name: 'Agent Alpha', status: 'Active' },
  { id: 'agent2', name: 'Agent Beta', status: 'Idle' },
  { id: 'agent3', name: 'Agent Gamma', status: 'Busy' },
];

export default function AgentsPage() {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mode, setMode] = useState<'cloud' | 'local'>('cloud');

  const selectedAgent = agentsDummy.find(a => a.id === selectedAgentId);

  return (
    <div className="flex h-full bg-gray-900 text-white">
      {/* Sidebar with list of agents and New Session button */}
      <aside className="w-72 border-r border-gray-700 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold">Agents</h2>
          <button className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-sm">
            New Session
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto">
          {agentsDummy.map(agent => (
            <button
              key={agent.id}
              onClick={() => setSelectedAgentId(agent.id)}
              className={`w-full text-left px-4 py-2 hover:bg-gray-700 focus:bg-gray-700 transition-colors border-l-4 ${
                selectedAgentId === agent.id ? 'border-blue-500 bg-gray-800' : 'border-transparent'
              }`}
            >
              <div className="font-medium">{agent.name}</div>
              <div className="text-xs text-gray-400">{agent.status}</div>
            </button>
          ))}
        </nav>
      </aside>

      {/* Main area with agent details, input box, and mode toggle */}
      <main className="flex-1 flex flex-col">
        <header className="flex items-center justify-between border-b border-gray-700 p-4">
          <h1 className="text-xl font-bold">{selectedAgent ? selectedAgent.name : 'Select an Agent'}</h1>
          <div>
            <label className="mr-2">Mode:</label>
            <select
              value={mode}
              onChange={e => setMode(e.target.value as 'cloud' | 'local')}
              className="bg-gray-800 text-white rounded px-2 py-1"
            >
              <option value="cloud">Cloud</option>
              <option value="local">Local</option>
            </select>
          </div>
        </header>

        {selectedAgent ? (
          <section className="flex-1 p-4 overflow-auto">
            {/* Placeholder for pinned info bar */}
            <div className="bg-gray-800 p-3 rounded mb-4">
              Pinned info bar with mode: {mode}
            </div>

            {/* Input area for interaction with the selected agent */}
            <textarea
              placeholder="Type a message or command to the agent..."
              className="w-full h-40 rounded bg-gray-900 border border-gray-700 p-2 text-white resize-none"
            />
          </section>
        ) : (
          <section className="flex-1 flex items-center justify-center text-gray-500">
            Select an agent from the sidebar to start.
          </section>
        )}
      </main>
    </div>
  );
}
