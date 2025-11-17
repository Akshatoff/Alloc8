# alloc8_app.py
"""
Alloc8: Optimal Resource Distribution Planner
---------------------------------------------
- Uses OpenRouteService API for real-world driving distances (with Haversine fallback)
- Uses OR-Tools for Vehicle Routing with capacity constraints
- Returns optimized routes with loads and total distances

Run:
    pip install flask ortools requests
    python alloc8_app.py

Endpoint:
    POST /generate-plan
    Example body:
    {
      "strategy": "fastest",
      "parsedNeeds": {
        "locations": [
          {"name": "A", "lat": 33.9425, "lon": -118.4081, "needs": {"water": 10}},
          {"name": "B", "lat": 33.9500, "lon": -118.4000, "needs": {"food": 20}}
        ]
      }
    }
"""
from flask import Flask, request, jsonify
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp
import requests
import math
import logging
from flask_cors import CORS


app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
CORS(app)
# ---------------------- Helpers ----------------------


def get_haversine_distance(coord1, coord2):
    """Return distance in meters between two (lat, lon) pairs using Haversine."""
    R = 6371  # km
    lat1, lon1 = math.radians(coord1[0]), math.radians(coord1[1])
    lat2, lon2 = math.radians(coord2[0]), math.radians(coord2[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return int(R * c * 1000)  # meters as int


def create_haversine_matrix(locations, depot):
    """Create a distance matrix (meters) including depot first using Haversine."""
    coords = [(depot["lat"], depot["lon"])] + [(loc["lat"], loc["lon"]) for loc in locations]
    n = len(coords)
    matrix = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                matrix[i][j] = 0
            else:
                matrix[i][j] = get_haversine_distance(coords[i], coords[j])
    return matrix


# ---------------------- ORS Distance Matrix ----------------------


def create_distance_matrix_with_ors(locations, depot, ors_api_key, timeout_seconds=10):
    """
    Generate a real-world distance matrix (in meters) using OpenRouteService API.
    Includes the depot as the first location.

    Returns: distance_matrix (list of lists)
    Raises: Exception on ORS failure.
    """
    coords = [[depot["lon"], depot["lat"]]] + [[loc["lon"], loc["lat"]] for loc in locations]
    url = "https://api.openrouteservice.org/v2/matrix/driving-car"
    headers = {"Authorization": ors_api_key, "Content-Type": "application/json"}
    body = {"locations": coords, "metrics": ["distance"], "units": "m"}

    resp = requests.post(url, json=body, headers=headers, timeout=timeout_seconds)
    data = resp.json()
    if resp.status_code != 200 or "distances" not in data:
        raise Exception(f"ORS error ({resp.status_code}): {data}")
    # Ensure values are ints
    distances = data["distances"]
    distances_int = [[int(x) for x in row] for row in distances]
    return distances_int


# ---------------------- Optimization Logic ----------------------


def run_optimization(collected_data):
    strategy = collected_data.get("strategy", "fastest")
    # Default depot: LAX (customize as needed)
    depot_info = collected_data.get("depot", {"lat": 33.9416, "lon": -118.4085, "name": "Main Depot (LAX)"})
    locations = collected_data.get("parsedNeeds", {}).get("locations", [])

    if not locations:
        raise ValueError("No locations to plan for.")

    # Try ORS first, fall back to Haversine if ORS fails or key missing
    ors_key = collected_data.get("ors_api_key") or "YOUR_ORS_API_KEY"
    distance_matrix = None
    if ors_key and ors_key != "YOUR_ORS_API_KEY":
        try:
            logging.info("Requesting distance matrix from OpenRouteService...")
            distance_matrix = create_distance_matrix_with_ors(locations, depot_info, ors_key)
            logging.info("Received distance matrix from ORS.")
        except Exception as e:
            logging.warning(f"ORS failed, falling back to Haversine: {e}")

    if distance_matrix is None:
        logging.info("Using Haversine distance matrix (fallback).")
        distance_matrix = create_haversine_matrix(locations, depot_info)

    # Demands: depot first (0), then each location's total needs
    demands = [0]
    for loc in locations:
        total_units = (
            int(loc.get("needs", {}).get("water", 0))
            + int(loc.get("needs", {}).get("food", 0))
            + int(loc.get("needs", {}).get("medical", 0))
        )
        demands.append(total_units)

    # Vehicle capacities
    vehicle_capacities = collected_data.get("vehicle_capacities", [1000, 1000])
    num_vehicles = len(vehicle_capacities)

    # Create the routing index manager and model
    manager = pywrapcp.RoutingIndexManager(len(distance_matrix), num_vehicles, 0)
    routing = pywrapcp.RoutingModel(manager)

    # Transit callback (distance). OR-Tools expects int64 values.
    def distance_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return int(distance_matrix[from_node][to_node])

    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    # Capacity/demand callback
    def demand_callback(from_index):
        from_node = manager.IndexToNode(from_index)
        return int(demands[from_node])

    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        int(0),  # null slack
        [int(c) for c in vehicle_capacities],
        True,
        "Capacity",
    )

    # Optional Distance dimension
    # Make sure we pass explicit ints to avoid binding type errors
    max_distance = int(sum(sum(int(x) for x in row) for row in distance_matrix))
    routing.AddDimension(
        transit_callback_index,
        int(0),         # slack_max (int)
        max_distance,   # capacity (int)
        True,         # fix_start_cumul_to_zero — pass as int(1) to avoid binding ambiguity
        "Distance",
    )
    distance_dimension = routing.GetDimensionOrDie("Distance")

    # Search parameters
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search_parameters.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search_parameters.time_limit.seconds = int(collected_data.get("time_limit_seconds", 10))

    # Solve
    solution = routing.SolveWithParameters(search_parameters)
    if not solution:
        raise Exception("No solution found by the optimization engine.")

    # Parse solution into JSON
    routes = []
    total_distance = 0
    total_load = 0

    def node_name(node_idx):
        if node_idx == 0:
            return depot_info.get("name", "Depot")
        loc = locations[node_idx - 1]
        return loc.get("name", f"Loc_{node_idx}")

    for vehicle_id in range(num_vehicles):
        index = routing.Start(vehicle_id)
        route = {"vehicle_id": vehicle_id, "stops": [], "distance_meters": 0, "load": 0}

        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            route["stops"].append({"node_index": node, "name": node_name(node)})
            next_index = solution.Value(routing.NextVar(index))
            # arc cost can be retrieved directly
            route["distance_meters"] += int(routing.GetArcCostForVehicle(index, next_index, vehicle_id))
            index = next_index

        # Add the end depot
        end_node = manager.IndexToNode(index)
        route["stops"].append({"node_index": end_node, "name": node_name(end_node)})

        # Compute load
        load = sum(int(demands[stop["node_index"]]) for stop in route["stops"])
        route["load"] = load
        total_distance += route["distance_meters"]
        total_load += load

        # keep only non-empty routes
        if len(route["stops"]) > 2 or route["load"] > 0:
            routes.append(route)

    final_plan_json = {
        "locations": locations,
        "depot": depot_info,
        "routes": routes,
        "summary": {
            "totalDistanceMeters": int(total_distance),
            "totalResources": int(sum(demands)),
            "assignedResources": int(total_load),
            "totalTrucks": num_vehicles,
            "strategy": strategy,
            "title": f"Plan: {strategy.title()}",
            "description": "This plan minimizes real-world driving distance (ORS) or Haversine if ORS failed.",
        },
    }

    return final_plan_json


# ---------------------- Flask Endpoint ----------------------


@app.route("/generate-plan", methods=["POST"])
def generate_plan_endpoint():
    try:
        collected_data = request.get_json(force=True)
        plan_json = run_optimization(collected_data)
        return jsonify(plan_json)
    except Exception as e:
        logging.exception("Error while generating plan")
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    app.run(debug=True, port=5000)