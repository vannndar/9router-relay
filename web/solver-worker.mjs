import { solveStrategicBoard } from './solver-strategy.mjs';
self.onmessage = ({ data }) => {
  try {
    const result = solveStrategicBoard(data.board,data.pieces,{comboRemaining:data.comboRemaining,
      onProgress:progress => self.postMessage({type:'progress',...progress})});
    self.postMessage({ type: 'result', result });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
