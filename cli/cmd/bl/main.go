package main

import (
	"botlake/internal/app"
	"os"
)

func main() { os.Exit(app.BL(os.Args[1:])) }
