# Simulation bench

Runs the real history reader of the server against a simulated data lake that holds a synthetic machine history (fixed seed, 5400 points over six pages) and fails on command.

Scenarios:

- a healthy lake returns every point, in order, across six pages, stops at the number of points that was wanted and gives the same answer twice;
- an error status, a refused token, a body that is not JSON, a body of the wrong shape, a body cut short, a body far too big, a stall longer than the timeout and a cut connection all end in an error and never in invented points;
- a page with junk points keeps only the valid ones;
- a cursor that never ends does not loop forever;
- a lake that was still starting is read correctly once it is up;
- the token goes only to the lake it was given.

Part two (`tests/simulation-bench-fleet.test.ts`) reads the real server with a real OPC UA client while its two live sources fail:

- a vehicle that publishes on a fixed seed through a broker made for the tests: the node shows the last good value, garbage (not JSON, a value of the wrong type, a path of another vehicle, a path with dot-dot, a number that is not finite, the same path twice) changes nothing, the broker dropping its clients is survived by a reconnection and the next value is read;
- a node keeps the type it was created with when the vehicle sends the same path with another type;
- a vehicle that goes silent, or a broker that goes away, leaves the last value with an uncertain quality, and its next message turns the quality back to good;
- the roster of HYDRA-UMC-SERVER on a fixed seed, with a server that is off, answers 500, 503 or 401, sends a page that is not JSON or a JSON cut in the middle: when it answers the robots are what it said, and when it does not answer no robot is online and the roster is marked stale; the same seed gives the same sequence twice.

The evidence of this project is `simulator`: it says nothing about real machines, real networks or real load.

Physical tests still pending:

- a real SCADA or UaExpert with a real broker and a bridge of the fleet: stop the broker for ten seconds; expected: the Fleet nodes keep their last value with an uncertain quality while it is away and are good again after it returns and the bridge publishes;
- a running HYDRA-UMC-SERVER with a real robot: stop the server and start it again; expected: the Online variables of the robots are false with an uncertain quality while it is off and show the real state afterwards;
- a real data lake with a real machine history: read the history of a node across the pages while the lake restarts; expected: an error and not invented points, then the full history.
