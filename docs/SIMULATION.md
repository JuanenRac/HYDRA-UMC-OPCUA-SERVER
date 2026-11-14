# Simulation bench

Runs the real history reader of the server against a simulated data lake that holds a synthetic machine history (fixed seed, 5400 points over six pages) and fails on command.

Scenarios:

- a healthy lake returns every point, in order, across six pages, stops at the number of points that was wanted and gives the same answer twice;
- an error status, a refused token, a body that is not JSON, a body of the wrong shape, a body cut short, a body far too big, a stall longer than the timeout and a cut connection all end in an error and never in invented points;
- a page with junk points keeps only the valid ones;
- a cursor that never ends does not loop forever;
- a lake that was still starting is read correctly once it is up;
- the token goes only to the lake it was given.

The evidence of this project is `simulator`: it says nothing about real machines, real networks or real load.
