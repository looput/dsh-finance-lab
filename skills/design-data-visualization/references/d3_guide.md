# D3.js Guide

## Basic Setup

```html
<script src="https://d3js.org/d3.v7.min.js"></script>
```

## Bar Chart

```javascript
const data = [4, 8, 15, 16, 23, 42];
const width = 400;
const height = 300;
const margin = {top: 20, right: 20, bottom: 30, left: 40};

const svg = d3.select("body")
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom);

const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

const x = d3.scaleBand()
    .range([0, width])
    .padding(0.1);

const y = d3.scaleLinear()
    .range([height, 0]);

x.domain(data.map((d, i) => i));
y.domain([0, d3.max(data)]);

g.append("g")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x));

g.append("g")
    .call(d3.axisLeft(y));

g.selectAll(".bar")
    .data(data)
    .enter().append("rect")
    .attr("class", "bar")
    .attr("x", (d, i) => x(i))
    .attr("width", x.bandwidth())
    .attr("y", d => y(d))
    .attr("height", d => height - y(d));
```

## Line Chart

```javascript
const line = d3.line()
    .x(d => x(d.date))
    .y(d => y(d.value))
    .curve(d3.curveMonotoneX);

g.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", "steelblue")
    .attr("stroke-width", 2)
    .attr("d", line);
```

## Scales

```javascript
// Linear scale
const y = d3.scaleLinear()
    .domain([0, d3.max(data)])
    .range([height, 0]);

// Time scale
const x = d3.scaleTime()
    .domain(d3.extent(data, d => d.date))
    .range([0, width]);

// Ordinal scale
const color = d3.scaleOrdinal()
    .domain(data.map(d => d.category))
    .range(d3.schemeCategory10);
```

## Axes

```javascript
g.append("g")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x));

g.append("g")
    .call(d3.axisLeft(y));
```

## Resources

- D3.js Documentation: https://d3js.org/
- Observable Examples: https://observablehq.com/@d3
- D3 Gallery: https://observablehq.com/@d3/gallery
