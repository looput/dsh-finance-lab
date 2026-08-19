# Chart.js Guide

## Basic Setup

```html
<!DOCTYPE html>
<html>
<head>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <canvas id="myChart"></canvas>
    <script>
        const ctx = document.getElementById('myChart');
        const chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Red', 'Blue', 'Yellow', 'Green', 'Purple'],
                datasets: [{
                    label: 'Dataset',
                    data: [12, 19, 3, 5, 2],
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: 'Chart Title'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    </script>
</body>
</html>
```

## Chart Types

### Bar Chart

```javascript
type: 'bar',
// or
type: 'horizontalBar',
```

### Line Chart

```javascript
type: 'line',
data: {
    datasets: [{
        label: 'Series 1',
        data: [{x: 1, y: 2}, {x: 2, y: 3}],
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1
    }]
}
```

### Pie Chart

```javascript
type: 'pie',
data: {
    labels: ['Red', 'Blue', 'Yellow'],
    datasets: [{
        data: [300, 50, 100],
        backgroundColor: [
            'rgb(255, 99, 132)',
            'rgb(54, 162, 235)',
            'rgb(255, 205, 86)'
        ]
    }]
}
```

### Scatter Plot

```javascript
type: 'scatter',
data: {
    datasets: [{
        label: 'Scatter Dataset',
        data: [{x: -10, y: 0}, {x: 0, y: 10}, {x: 10, y: 5}],
        backgroundColor: 'rgb(255, 99, 132)'
    }]
}
```

## Styling

### Colors

```javascript
backgroundColor: [
    'rgba(255, 99, 132, 0.2)',
    'rgba(54, 162, 235, 0.2)',
    'rgba(255, 205, 86, 0.2)'
],
borderColor: [
    'rgba(255, 99, 132, 1)',
    'rgba(54, 162, 235, 1)',
    'rgba(255, 205, 86, 1)'
]
```

### Responsive

```javascript
options: {
    responsive: true,
    maintainAspectRatio: false
}
```

## Plugins

### Legend

```javascript
options: {
    plugins: {
        legend: {
            display: true,
            position: 'top'
        }
    }
}
```

### Tooltips

```javascript
options: {
    plugins: {
        tooltip: {
            enabled: true,
            mode: 'index',
            intersect: false
        }
    }
}
```
